import { DirectUpload } from "./direct_upload"
import { dispatchEvent } from "./helpers"

export class DirectUploadController {
  constructor(input, file) {
    this.input = input
    this.file = file
    const customHeaders = {}
    const options = {
      keyPrefix: this.keyPrefix,
      keepFilename: this.keepFilename,
      useMultipart: this.useMultipart
    }
    this.directUpload = new DirectUpload(this.file, this.url, this, customHeaders, options)
    this.dispatch("initialize")
  }

  start(callback) {
    const hiddenInput = document.createElement("input")
    hiddenInput.type = "hidden"
    hiddenInput.name = this.input.name
    this.input.insertAdjacentElement("beforebegin", hiddenInput)

    this.dispatch("start")

    this.directUpload.create((error, attributes) => {
      if (error) {
        hiddenInput.parentNode.removeChild(hiddenInput)
        this.dispatchError(error)
      } else {
        hiddenInput.value = attributes.signed_id
      }

      this.dispatch("end")
      callback(error)
    })
  }

  uploadRequestDidProgress(event) {
    // Scale upload progress to 0-90% range
    const progress = (event.loaded / event.total) * 90
    if (progress && !this.simulating) {
      this.dispatch("progress", { progress })
    }
  }

  get url() {
    return this.input.getAttribute("data-direct-upload-url")
  }

  get keyPrefix() {
    return this.input.getAttribute("data-key-prefix")
  }

  get keepFilename() {
    return this.input.getAttribute("data-keep-filename") === "true"
  }

  get useMultipart() {
    return this.input.getAttribute("data-use-multipart") === "true"
  }

  dispatch(name, detail = {}) {
    detail.file = this.file
    detail.id = this.directUpload.id
    return dispatchEvent(this.input, `direct-upload:${name}`, { detail })
  }

  dispatchError(error) {
    const event = this.dispatch("error", { error })
    if (!event.defaultPrevented) {
      alert(error)
    }
  }

  // DirectUpload delegate

  directUploadWillCreateBlobWithXHR(xhr) {
    this.dispatch("before-blob-request", { xhr })
  }

  directUploadWillStoreFileWithXHR(xhr) {
    this.dispatch("before-storage-request", { xhr })
    xhr.upload.addEventListener("progress", event => this.uploadRequestDidProgress(event))

    // Start simulating progress after upload completes
    this.simulating = false
    xhr.upload.addEventListener("loadend", () => {
      if (!this.simulating) {
        this.simulateResponseProgress(xhr)
        this.simulating = true
      }
    })
  }

  simulateResponseProgress(xhr) {
    let progress = 90
    const startTime = Date.now()

    const updateProgress = () => {
      // Simulate progress from 90% to 99% over estimated time
      const elapsed = Date.now() - startTime
      const estimatedResponseTime = this.estimateResponseTime()
      const responseProgress = Math.min(elapsed / estimatedResponseTime, 1)
      progress = 90 + (responseProgress * 9) // 90% to 99%

      this.dispatch("progress", { progress })

      // Continue until response arrives or we hit 99%
      if (progress < 99) {
        requestAnimationFrame(updateProgress)
      }
    }

    // Stop simulation when response arrives
    xhr.addEventListener("loadend", () => {
      if (xhr.status === 200) {
        this.dispatch("progress", { progress: 100 })
      }
    })

    requestAnimationFrame(updateProgress)
  }

  estimateResponseTime() {
    // Base estimate: 1 second for small files, scaling up for larger files
    const fileSize = this.file.size
    const MB = 1024 * 1024

    if (fileSize < MB) {
      return 1000 // 1 second for files under 1MB
    } else if (fileSize < 10 * MB) {
      return 2000 // 2 seconds for files 1-10MB
    } else {
      return 3000 + (fileSize / MB) // 3+ seconds for larger files
    }
  }
}
