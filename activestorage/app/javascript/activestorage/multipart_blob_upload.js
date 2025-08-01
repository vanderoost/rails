export class MultipartBlobUpload {
  constructor(blobRecord) {
    this.file = blobRecord.file
    this.blobId = blobRecord.attributes.id

    const { upload_id, part_size, part_urls } = blobRecord.directUploadData

    this.uploadId = upload_id
    this.partSize = part_size
    this.partUrls = part_urls
    this.uploadedParts = []
    this.currentPartIndex = 0

    console.debug("blobId:", this.blobId)
    console.debug("uploadId:", this.uploadId)

    // Add a dummy xhr for compatibility with the notify system
    this.xhr = new XMLHttpRequest()
  }

  create(callback) {
    console.debug("MultipartBlobUpload#create starting multipart upload")
    this.callback = callback
    this.uploadNextPart()
  }

  uploadNextPart() {
    if (this.currentPartIndex >= this.partUrls.length) {
      // All parts uploaded, complete the multipart upload
      console.debug("All parts uploaded, completing multipart upload")
      this.completeMultipartUpload()
      return
    }

    const partData = this.partUrls[this.currentPartIndex]
    const start = (partData.part_number - 1) * this.partSize
    const end = Math.min(start + this.partSize, this.file.size)
    const chunk = this.file.slice(start, end)

    console.debug(`Uploading part ${partData.part_number}/${this.partUrls.length}`)

    this.uploadPart(partData.url, chunk, (error, etag) => {
      if (error) {
        this.callback(error)
        return
      }

      this.uploadedParts.push({
        etag: etag,
        part_number: partData.part_number,
      })

      this.currentPartIndex++
      this.uploadNextPart()
    })
  }

  uploadPart(url, chunk, callback) {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url, true)
    xhr.responseType = "text"

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag")
        callback(null, etag)
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
      upload_id: this.uploadId,
      parts: this.uploadedParts
    }))
  }

  // TODO: See if we can reuse something else that also needs the CSRF token
  getCSRFToken() {
    const meta = document.querySelector("meta[name=\"csrf-token\"]")
    return meta ? meta.content : ""
  }
}
