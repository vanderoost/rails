import { getMetaValue } from "./helpers"
import { RobustRequest } from "./robust_request"

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
    this.progressInterval = 100
    this.retryTimeoutId = null
    this.retryInterval = 500
    this.robustRequest = new RobustRequest()
    this.partProgress = new Array(part_urls.length).fill(0)

    // First aggregate progress of all parts, then used as a complete-multipart request
    this.xhr = new XMLHttpRequest()
  }

  create(callback) {
    this.callback = callback
    this.uploadParts()
  }

  uploadParts() {
    this.uploadPartsWithConcurrencyLimit(this.partUrls, this.maxConcurrentUploads)
      .then(() => this.completeMultipartUpload())
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

      this.uploadPart(partData.url, chunk, (error, etag) => {
        if (error) {
          reject(error)
        } else {
          this.uploadedParts.push({ etag: etag, part_number: partData.part_number })
          resolve(etag)
        }
      }, partData.part_number)
    })
  }

  uploadPart(url, chunk, callback, partNumber) {
    this.robustRequest.execute((onSuccess, onError) => {
      const partXhr = new XMLHttpRequest()
      partXhr.open("PUT", url, true)
      partXhr.responseType = "text"

      partXhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          this.updatePartProgress(partNumber - 1, event.loaded)
        }
      })

      partXhr.addEventListener("load", () => {
        if (partXhr.status >= 200 && partXhr.status < 300) {
          this.updatePartProgress(partNumber - 1, chunk.size)
          onSuccess(partXhr.getResponseHeader("ETag"))
        } else {
          onError({
            status: partXhr.status,
            message: `Failed to upload part: ${partXhr.status}`,
            context: "Part upload"
          })
        }
      })

      partXhr.addEventListener("error", () => {
        onError({
          networkError: true,
          message: "Network error",
          context: "Part upload"
        })
      })

      partXhr.send(chunk)
    })
      .then(etag => callback(null, etag))
      .catch(error => callback(new Error(error.message)))
  }

  updatePartProgress(partIndex, progress) {
    this.partProgress[partIndex] = progress
    if (this.emitProgressTimeoutId) { return }
    this.emitProgressTimeoutId = setTimeout(() => this.emitProgressEvent(), this.progressInterval)
  }

  emitProgressEvent() {
    this.emitProgressTimeoutId = null
    const totalBytesUploaded = this.partProgress.reduce((sum, p) => sum + p, 0)
    const progressEvent = new ProgressEvent("progress", {
      lengthComputable: true,
      loaded: totalBytesUploaded,
      total: this.file.size
    })
    this.xhr.upload.dispatchEvent(progressEvent)
  }

  completeMultipartUpload() {
    this.uploadedParts.sort((a, b) => a.part_number - b.part_number)
    const completeUrl = `/rails/active_storage/direct_uploads/${this.blobId}`

    this.xhr.open("PUT", completeUrl, true)
    this.xhr.setRequestHeader("Content-Type", "application/json")

    const csrfToken = getMetaValue("csrf-token")
    if (csrfToken != undefined) {
      this.xhr.setRequestHeader("X-CSRF-Token", csrfToken)
    }

    this.xhr.onload = () => {
      if (this.xhr.status === 202) {
        this.retryCompleteMultipartUpload()
      } else if (this.xhr.status >= 200 && this.xhr.status < 300) {
        this.callback(null, this.file)
      } else {
        this.requestDidError()
      }
    }

    this.xhr.onerror = (e) => {
      this.callback(e)
    }

    this.xhr.send(JSON.stringify({
      blob: { upload_id: this.uploadId, parts: this.uploadedParts }
    }))
  }

  requestDidError() {
    this.callback(`Error storing "${this.file.name}". Status: ${this.xhr.status}`)
  }

  retryCompleteMultipartUpload() {
    clearTimeout(this.retryTimeoutId)
    const jitter = Math.round(Math.random() * 300)
    this.retryTimeoutId = setTimeout(() => this.completeMultipartUpload(), this.retryInterval + jitter)
    this.retryInterval = Math.min(Math.round(this.retryInterval * 1.5), 3000)
  }
}
