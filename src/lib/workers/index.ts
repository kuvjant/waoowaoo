import 'dotenv/config'
import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import { setProxy } from '../../../lib/prompts/proxy'
import { createImageWorker } from './image.worker'
import { createVideoWorker } from './video.worker'
import { createVoiceWorker } from './voice.worker'
import { createTextWorker } from './text.worker'

let workers: ReturnType<typeof createImageWorker>[] = []

async function main() {
  // 在任意出站请求前设置代理（PROXY_URL），避免 worker 内 fetch 不走代理
  await setProxy()
  workers = [createImageWorker(), createVideoWorker(), createVoiceWorker(), createTextWorker()]
  _ulogInfo(`[Workers] started: ${workers.length}`)
  for (const worker of workers) {
    worker.on('ready', () => {
      _ulogInfo(`[Workers] ready: ${worker.name}`)
    })
    worker.on('error', (err) => {
      _ulogError(`[Workers] error: ${worker.name}`, err.message)
    })
    worker.on('failed', (job, err) => {
      _ulogError(`[Workers] job failed: ${worker.name}`, {
        jobId: job?.id,
        taskId: job?.data?.taskId,
        taskType: job?.data?.type,
        error: err.message,
      })
    })
  }
}

async function shutdown(signal: string) {
  _ulogInfo(`[Workers] shutdown signal: ${signal}`)
  await Promise.all(workers.map(async (worker) => await worker.close()))
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

main().catch((err) => {
  _ulogError('[Workers] startup failed', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
