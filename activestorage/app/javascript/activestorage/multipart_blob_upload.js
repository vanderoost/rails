export class MultipartBlobUpload {
  constructor(blobRecord) {
    this.file = blobRecord.file
    this.blobId = blobRecord.attributes.id

    const { upload_id, part_size, part_urls } = blobRecord.directUploadData

    this.uploadId = upload_id
    this.partSize = part_size
    this.partUrls = part_urls
    this.uploadedParts = []
    this.maxConcurrentUploads = 3

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
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url, true)
    xhr.responseType = "text"
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        callback(null, xhr.getResponseHeader("ETag"))
      } else {
        callback(new Error(`Failed to upload part: ${xhr.status}`))
      }
    })

    xhr.addEventListener("error", () => {
      callback(new Error("Network error"))
    })

    xhr.send(chunk)
  }

  completeMultipartUpload() {
    // Sort parts by part_number to ensure correct order
    this.uploadedParts.sort((a, b) => a.part_number - b.part_number)

    const xhr = new XMLHttpRequest()
    const completeUrl = `/rails/active_storage/direct_uploads/${this.blobId}`

    xhr.open("PUT", completeUrl, true)
    xhr.setRequestHeader("Content-Type", "application/json")
    xhr.setRequestHeader("X-CSRF-Token", this.getCSRFToken())

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        this.callback(null, this.file)
      } else {
        this.callback(new Error("Failed to complete multipart upload"))
      }
    })

    xhr.send(JSON.stringify({
      blob: {
        upload_id: this.uploadId,
        parts: this.uploadedParts
      }
    }))
  }

  // TODO: See if we can reuse something else that also needs the CSRF token
  getCSRFToken() {
    const meta = document.querySelector("meta[name=\"csrf-token\"]")
    return meta ? meta.content : ""
  }
}
