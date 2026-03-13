import { NextRequest, NextResponse } from 'next/server'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { prisma } from '@/lib/prisma'
import { retryFailedStep, getRunById } from '@/lib/run-runtime/service'
import { resolveTaskLocale } from '@/lib/task/resolve-locale'
import { defaultLocale } from '@/i18n/routing'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE, type TaskType } from '@/lib/task/types'

const RETRY_SUPPORTED_TASK_TYPES: ReadonlySet<string> = new Set<string>([
  TASK_TYPE.STORY_TO_SCRIPT_RUN,
  TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN,
  TASK_TYPE.CLIPS_BUILD,
])

/** stepKey 匹配 clip_<id>_phase1 | phase2_cinematography | phase2_acting | phase3_detail 时，重试需提交 SCRIPT_TO_STORYBOARD_RUN */
const STORYBOARD_RETRY_STEP_PATTERN = /^clip_(.+)_(phase1|phase2_cinematography|phase2_acting|phase3_detail)$/

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveTaskType(run: {
  workflowType: string
  taskType: string | null
}): TaskType {
  const candidate = readString(run.taskType || run.workflowType)
  if (!candidate || !RETRY_SUPPORTED_TASK_TYPES.has(candidate)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'RUN_STEP_RETRY_UNSUPPORTED_TASK_TYPE',
      taskType: candidate || null,
    })
  }
  return candidate as TaskType
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ runId: string; stepKey: string }> },
) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  let { runId, stepKey: rawStepKey } = await context.params
  // 部分运行时 params 可能为空，从 pathname 回退解析
  const pathname = request.nextUrl?.pathname ?? ''
  if (!runId || !rawStepKey) {
    const runMatch = /\/api\/runs\/([^/]+)\/steps\/([^/]+)\/retry$/.exec(pathname)
    if (runMatch) {
      runId = runId || runMatch[1] || ''
      rawStepKey = rawStepKey || runMatch[2] || ''
    }
  }
  const stepKey = decodeURIComponent(typeof rawStepKey === 'string' ? rawStepKey : Array.isArray(rawStepKey) ? rawStepKey.join('/') : '').trim()
  if (!runId || !stepKey) {
    throw new ApiError('INVALID_PARAMS', {
      message: 'runId and stepKey are required',
      code: 'RUN_STEP_RETRY_MISSING_PARAMS',
      runId: runId || null,
      stepKey: stepKey || null,
    })
  }

  const run = await getRunById(runId)
  if (!run || run.userId !== session.user.id) {
    throw new ApiError('NOT_FOUND')
  }

  const body = await request.json().catch(() => null)
  const payload = toObject(body)
  const modelOverride = readString(payload.modelOverride)
  const reason = readString(payload.reason)

  let prepared: Awaited<ReturnType<typeof retryFailedStep>> = null
  try {
    prepared = await retryFailedStep({
      runId,
      userId: session.user.id,
      stepKey,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'RUN_STEP_NOT_FOUND') {
      throw new ApiError('NOT_FOUND')
    }
    if (message === 'RUN_STEP_NOT_FAILED') {
      throw new ApiError('INVALID_PARAMS', {
        message: 'Only failed steps can be retried. This step is not in failed state.',
        code: 'RUN_STEP_RETRY_ONLY_FAILED',
        stepKey,
      })
    }
    throw error
  }
  if (!prepared) {
    throw new ApiError('NOT_FOUND')
  }

  // clip_*_phase* 步骤一律按 script-to-storyboard 重试，不依赖 run.taskType，避免 run 类型未在支持列表中报错
  const isStoryboardRetryStep = STORYBOARD_RETRY_STEP_PATTERN.test(stepKey)
  let taskType: TaskType
  if (isStoryboardRetryStep) {
    taskType = TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN as TaskType
  } else {
    taskType = resolveTaskType(run)
  }
  const runInput = toObject(run.input)
  // locale 优先从请求体 / run.input / Accept-Language 取，缺失时用默认语言，避免 INVALID_PARAMS
  const locale = resolveTaskLocale(request, { ...runInput, ...payload }) ?? defaultLocale
  const taskPayload: Record<string, unknown> = {
    ...runInput,
    episodeId: run.episodeId || runInput.episodeId || null,
    runId,
    retryStepKey: stepKey,
    retryStepAttempt: prepared.retryAttempt,
    retryReason: reason || null,
    displayMode: 'detail',
    meta: {
      ...toObject(runInput.meta),
      locale,
      runId,
      retryStepKey: stepKey,
      retryStepAttempt: prepared.retryAttempt,
      retryReason: reason || null,
    },
  }
  if (modelOverride) {
    taskPayload.model = modelOverride
    taskPayload.analysisModel = modelOverride
  }
  // 计费需 model/analysisModel，缺一则 buildTextTaskInfo 返回 null，ENFORCE 下会抛 INVALID_PARAMS；用 run.input 或项目配置补全
  if (!readString(taskPayload.model) && !readString(taskPayload.analysisModel)) {
    const np = await prisma.novelPromotionProject.findUnique({
      where: { projectId: run.projectId },
      select: { analysisModel: true },
    })
    const fallback = (np?.analysisModel && typeof np.analysisModel === 'string')
      ? np.analysisModel.trim()
      : 'gpt-4o-mini'
    taskPayload.model = fallback
    taskPayload.analysisModel = fallback
  }
  // 显式传入 billingInfo，避免 submitTask 内 buildDefaultTaskBillingInfo 因 payload 差异返回 null 导致 ENFORCE 抛 INVALID_PARAMS
  const billingInfo = buildDefaultTaskBillingInfo(taskType, taskPayload) ?? null

  let submitResult: Awaited<ReturnType<typeof submitTask>>
  try {
    submitResult = await submitTask({
      userId: session.user.id,
      locale,
      requestId: getRequestId(request),
      projectId: run.projectId,
      episodeId: run.episodeId || null,
      type: taskType,
      targetType: run.targetType,
      targetId: run.targetId,
      payload: taskPayload,
      dedupeKey: null,
      priority: 3,
      billingInfo: billingInfo ?? undefined,
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new ApiError('INVALID_PARAMS', {
      message: `retry submit failed: ${msg}`,
      code: 'RUN_STEP_RETRY_SUBMIT_FAILED',
    })
  }

  return NextResponse.json({
    success: true,
    runId,
    stepKey,
    retryAttempt: prepared.retryAttempt,
    taskId: submitResult.taskId,
    async: true,
  })
})
