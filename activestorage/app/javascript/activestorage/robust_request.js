export class RobustRequest {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5
    this.baseDelay = options.baseDelay || 2000
    this.isRetryableStatus = options.isRetryableStatus ||
      ((status) => status >= 500 || status === 408 || status === 429)
  }

  execute(requestCallback, attempt = 0) {
    return new Promise((resolve, reject) => {
      const onSuccess = (result) => resolve(result)
      const onError = (error) => {
        if (attempt < this.maxRetries && this.shouldRetry(error)) {
          const delay = Math.round(this.baseDelay * Math.pow(2, attempt) + Math.random() * 1000)
          setTimeout(() => this.execute(requestCallback, attempt + 1).then(resolve, reject), delay)
        } else {
          reject(error)
        }
      }

      requestCallback(onSuccess, onError)
    })
  }

  shouldRetry(error) {
    return error.networkError || (error.status && this.isRetryableStatus(error.status))
  }
}
