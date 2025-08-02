export class MultipartBlobUpload {
  constructor(blobRecord) {
    this.file = blobRecord.file
    this.blobId = blobRecord.attributes.id

    const { upload_id, part_size, part_urls } = blobRecord.directUploadData

    this.uploadId = upload_id
    this.partSize = part_size
    this.partUrls = part_urls
    this.uploadedParts = []
    this.maxConcurrentUploads = 4
    this.retryableRequest = new RetryableRequest()

    // Add a dummy xhr for compatibility with the notify system
    this.xhr = new XMLHttpRequest()
  }

  create(callback) {
    this.callback = callback
    this.uploadPartsConcurrently()
  }

  uploadPartsConcurrently() {
    this.uploadPartsWithConcurrencyLimit(this.partUrls, this.maxConcurrentUploads)
      .then(() => {
        console.debug("All parts uploaded, completing multipart upload")
        this.completeMultipartUpload()
      })
      .catch(error => { this.callback(error) })
  }

  uploadPartsWithConcurrencyLimit(parts, limit) {
    return new Promise((resolve, reject) => {
      const results = []
      const executing = []
      let partIndex = 0

      const startNextUpload = () => {
        if (partIndex >= parts.length) {
          if (executing.length === 0) {
            resolve()
          }
          return
        }

        const partData = parts[partIndex++]
        const uploadPromise = this.uploadPartAsync(partData)

        results.push(uploadPromise)
        executing.push(uploadPromise)

        uploadPromise
          .then(() => {
            executing.splice(executing.indexOf(uploadPromise), 1)
            startNextUpload()
          })
          .catch(error => {
            executing.splice(executing.indexOf(uploadPromise), 1)
            reject(error)
          })
      }

      for (let i = 0; i < Math.min(limit, parts.length); i++) {
        startNextUpload()
      }
    })
  }

  uploadPartAsync(partData) {
    return new Promise((resolve, reject) => {
      const start = (partData.part_number - 1) * this.partSize
      const end = Math.min(start + this.partSize, this.file.size)
      const chunk = this.file.slice(start, end)

      console.debug(`Part ${partData.part_number}/${this.partUrls.length} starting`)

      this.uploadPart(partData.url, chunk, (error, etag) => {
        if (error) {
          reject(error)
        } else {
          this.uploadedParts.push({ etag: etag, part_number: partData.part_number })
          console.debug(`Part ${partData.part_number}/${this.partUrls.length} uploaded`)
          resolve(etag)
        }
      })
    })
  }

  uploadPart(url, chunk, callback) {
    this.retryableRequest.execute((onSuccess, onError) => {
      const xhr = new XMLHttpRequest()
      xhr.open("PUT", url, true)
      xhr.responseType = "text"

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onSuccess(xhr.getResponseHeader("ETag"))
        } else {
          onError({
            status: xhr.status,
            message: `Failed to upload part: ${xhr.status}`,
            context: "Part upload"
          })
        }
      })

      xhr.addEventListener("error", () => {
        onError({
          networkError: true,
          message: "Network error",
          context: "Part upload"
        })
      })

      xhr.send(chunk)
    })
      .then(etag => callback(null, etag))
      .catch(error => callback(new Error(error.message)))
  }

  completeMultipartUpload() {
    // Sort parts by part_number to ensure correct order
    this.uploadedParts.sort((a, b) => a.part_number - b.part_number)

    this.retryableRequest.execute((onSuccess, onError) => {
      const xhr = new XMLHttpRequest()
      const completeUrl = `/rails/active_storage/direct_uploads/${this.blobId}`

      xhr.open("PUT", completeUrl, true)
      xhr.setRequestHeader("Content-Type", "application/json")
      xhr.setRequestHeader("X-CSRF-Token", this.getCSRFToken())

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onSuccess(this.file)
        } else {
          onError({
            status: xhr.status,
            message: "Failed to complete multipart upload",
            context: "Complete multipart upload"
          })
        }
      })

      xhr.addEventListener("error", () => {
        onError({
          networkError: true,
          message: "Network error completing multipart upload",
          context: "Complete multipart upload"
        })
      })

      xhr.send(JSON.stringify({
        blob: {
          upload_id: this.uploadId,
          parts: this.uploadedParts
        }
      }))
    })
      .then(file => this.callback(null, file))
      .catch(error => this.callback(new Error(error.message)))
  }

  // TODO: See if we can reuse something else that also needs the CSRF token
  getCSRFToken() {
    const meta = document.querySelector("meta[name=\"csrf-token\"]")
    return meta ? meta.content : ""
  }
}

class RetryableRequest {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5
    this.baseDelay = options.baseDelay || 2000
    this.isRetryableStatus = options.isRetryableStatus || ((status) => status >= 500 || status === 408 || status === 429)
  }

  execute(requestFn, attempt = 0) {
    return new Promise((resolve, reject) => {
      const onSuccess = (result) => resolve(result)
      const onError = (error) => {
        if (attempt < this.maxRetries && this.shouldRetry(error)) {
          const delay = Math.round(this.baseDelay * Math.pow(2, attempt) + Math.random() * 1000)
          console.debug(`${error.context || "Request"} failed, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries}): ${error.message}`)
          setTimeout(() => {
            this.execute(requestFn, attempt + 1).then(resolve, reject)
          }, delay)
        } else {
          reject(error)
        }
      }

      requestFn(onSuccess, onError)
    })
  }

  shouldRetry(error) {
    return error.networkError || (error.status && this.isRetryableStatus(error.status))
  }
}

