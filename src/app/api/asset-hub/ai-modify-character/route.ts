import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { TASK_TYPE } from '@/lib/task/types'
import { maybeSubmitLLMTask } from '@/lib/llm-observe/route-task'

/**
 * 资产中心 - AI 修改角色形象描述（任务化）
 * POST /api/asset-hub/ai-modify-character
 * body: { characterId, appearanceIndex, currentDescription, modifyInstruction }
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const payload = await request.json().catch(() => null)
  const { characterId, appearanceIndex, currentDescription, modifyInstruction } = payload ?? {}

  const missing: string[] = []
  if (!characterId || typeof characterId !== 'string' || !characterId.trim()) missing.push('characterId')
  if (appearanceIndex === undefined || appearanceIndex === null) missing.push('appearanceIndex')
  if (!currentDescription || typeof currentDescription !== 'string' || !currentDescription.trim()) missing.push('currentDescription')
  if (!modifyInstruction || typeof modifyInstruction !== 'string' || !modifyInstruction.trim()) missing.push('modifyInstruction')
  if (missing.length > 0) {
    throw new ApiError('INVALID_PARAMS', { message: `Missing or invalid: ${missing.join(', ')}` })
  }

  const appearanceIndexNum = Number(appearanceIndex)
  const safeAppearanceIndex = Number.isFinite(appearanceIndexNum) && appearanceIndexNum >= 0 ? appearanceIndexNum : 0

  const character = await prisma.globalCharacter.findUnique({
    where: { id: characterId },
    select: { id: true, userId: true }})
  if (!character || character.userId !== session.user.id) {
    throw new ApiError('NOT_FOUND')
  }

  const asyncTaskResponse = await maybeSubmitLLMTask({
    request,
    userId: session.user.id,
    projectId: 'global-asset-hub',
    type: TASK_TYPE.ASSET_HUB_AI_MODIFY_CHARACTER,
    targetType: 'GlobalCharacter',
    targetId: characterId,
    routePath: '/api/asset-hub/ai-modify-character',
    body: { characterId, appearanceIndex: safeAppearanceIndex, currentDescription, modifyInstruction },
    dedupeKey: `asset_hub_ai_modify_character:${characterId}:${safeAppearanceIndex}`,
  })
  if (asyncTaskResponse) return asyncTaskResponse

  throw new ApiError('INVALID_PARAMS', {
    message: 'Task submission not available (LLM observe or async mode may be disabled)',
  })
})
