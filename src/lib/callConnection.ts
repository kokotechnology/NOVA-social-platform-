import { ApiError } from './api'

const retryDelaysMs = [250, 500, 1000, 1500]
const pendingConnectionMessages = new Set([
  'Your LiveKit media has not connected to this call.',
  'A second call participant has not connected to LiveKit yet.',
])

export async function retryCallConnectionConfirmation(confirm: () => Promise<void>, isCurrent: () => boolean) {
  for (let attempt = 0; isCurrent(); attempt += 1) {
    try {
      await confirm()
      return
    } catch (error) {
      const delay = retryDelaysMs[attempt]
      const isPendingConnection = error instanceof ApiError
        && error.status === 409
        && pendingConnectionMessages.has(error.message)
      if (!isPendingConnection || delay === undefined) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
