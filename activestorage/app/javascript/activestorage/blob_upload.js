export class BlobUpload {
  constructor(blob) {
    this.blob = blob
    this.file = blob.file

    const { url, headers } = blob.directUploadData

    this.xhr = new XMLHttpRequest
    this.xhr.open("PUT", url, true)
    this.xhr.responseType = "text"
    for (const key in headers) {
      this.xhr.setRequestHeader(key, headers[key])
    }
    this.xhr.addEventListener("load", event => this.requestDidLoad(event))
    this.xhr.addEventListener("error", event => this.requestDidError(event))

    this.aborted = false
  }

  create(callback) {
    this.callback = callback
    if (!this.aborted) {
      this.xhr.send(this.file.slice())
    }
  }

  requestDidLoad(event) {
    if (this.aborted) return

    const { status, response } = this.xhr
    if (status >= 200 && status < 300) {
      this.callback(null, response)
    } else {
      this.requestDidError(event)
    }
  }

  requestDidError(event) {
    if (this.aborted) return

    this.callback(
      `Error storing "${this.file.name}". Status: ${this.xhr.status}`
    )
  }

  abort() {
    if (this.aborted) return

    this.aborted = true

    if (this.xhr && this.xhr.readyState !== XMLHttpRequest.DONE) {
      try {
        this.xhr.abort()
      // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Ignore errors - XHR might already be completed
      }
    }

    // Call callback with error so the queue knows this upload is done
    if (this.callback) {
      this.callback("Upload aborted")
    }
  }
}
