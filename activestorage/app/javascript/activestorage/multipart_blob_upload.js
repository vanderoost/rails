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
    this.robustRequest = new RobustRequest()
    this.partProgress = new Array(part_urls.length).fill(0)

    // First aggregate progress of all parts, then used as
    // complete-multipart request
    this.xhr = new XMLHttpRequest()

    // Track active XHRs for abortion
    this.activeXhrs = []
    this.aborted = false
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
    // Check if upload was aborted before starting
    if (this.aborted) {
      callback(new Error("Upload aborted"))
      return
    }

    this.robustRequest.execute((onSuccess, onError) => {
      // Check again in case aborted during retry delay
      if (this.aborted) {
        onError({
          aborted: true,
          message: "Upload aborted",
          context: "Part upload"
        })
        return
      }

      const partXhr = new XMLHttpRequest()
      this.activeXhrs.push(partXhr)

      partXhr.open("PUT", url, true)
      partXhr.responseType = "text"

      partXhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          this.updatePartProgress(partNumber - 1, event.loaded)
        }
      })

      partXhr.addEventListener("load", () => {
        // Remove from active list
        const idx = this.activeXhrs.indexOf(partXhr)
        if (idx > -1) this.activeXhrs.splice(idx, 1)

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
        // Remove from active list
        const idx = this.activeXhrs.indexOf(partXhr)
        if (idx > -1) this.activeXhrs.splice(idx, 1)

        onError({
          networkError: true,
          message: "Network error",
          context: "Part upload"
        })
      })

      partXhr.send(chunk)
    })
      .then(etag => {
        if (!this.aborted) callback(null, etag)
      })
      .catch(error => {
        if (!this.aborted) callback(new Error(error.message))
      })
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
    // Check if aborted before completing
    if (this.aborted) {
      this.callback(new Error("Upload aborted"))
      return
    }

    this.uploadedParts.sort((a, b) => a.part_number - b.part_number)
    this.robustRequest.execute((onSuccess, onError) => {
      // Check again in case aborted during retry delay
      if (this.aborted) {
        onError({
          aborted: true,
          message: "Upload aborted",
          context: "Complete multipart upload"
        })
        return
      }

      const completeUrl =
        `/rails/active_storage/direct_uploads/${this.blobId}`

      this.xhr.open("PUT", completeUrl, true)
      this.xhr.setRequestHeader("Content-Type", "application/json")

      const csrfToken = getMetaValue("csrf-token")
      if (csrfToken != undefined) {
        this.xhr.setRequestHeader("X-CSRF-Token", csrfToken)
      }

      this.xhr.addEventListener("load", () => {
        if (this.xhr.status >= 200 && this.xhr.status < 300) {
          onSuccess(this.file)
        } else {
          onError({
            status: this.xhr.status,
            message: "Failed to upload",
            context: "Complete multipart upload"
          })
        }
      })

      this.xhr.addEventListener("error", () => {
        onError({
          networkError: true,
          message: "Network error",
          context: "Complete multipart upload"
        })
      })

      this.xhr.send(JSON.stringify({
        blob: {
          upload_id: this.uploadId,
          parts: this.uploadedParts
        }
      }))
    })
      .then(file => {
        if (!this.aborted) this.callback(null, file)
      })
      .catch(error => {
        if (!this.aborted) this.callback(new Error(error.message))
      })
  }

  abort() {
    if (this.aborted) return

    this.aborted = true

    // Abort all active part uploads
    this.activeXhrs.forEach(xhr => {
      try {
        xhr.abort()
      // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // XHR might already be completed, ignore errors
      }
    })
    this.activeXhrs = []

    // Abort the completion request if active
    if (this.xhr && this.xhr.readyState !== XMLHttpRequest.DONE) {
      try {
        this.xhr.abort()
      // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Ignore errors
      }
    }
  }
}
