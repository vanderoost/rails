import { FileChecksum } from "./file_checksum"
import { BlobRecord } from "./blob_record"
import { BlobUpload } from "./blob_upload"
import { MultipartBlobUpload } from "./multipart_blob_upload"

let id = 0

export class DirectUpload {
  constructor(file, url, delegate, customHeaders = {}, options = {}) {
    this.id = ++id
    this.file = file
    this.url = url
    this.delegate = delegate
    this.customHeaders = customHeaders
    this.customAttributes = {
      key_prefix: options.keyPrefix || "",
      keep_filename: options.keepFilename || false
    }
    this.useMultipart = options.useMultipart || false
  }

  create(callback) {
    this.maybeGetChecksum((error, checksum) => {
      if (error) return callback(error)

      this.createBlobRecord(checksum, (error, blobRecord) => {
        if (error) return callback(error)

        this.createBlobUpload(blobRecord, callback)
      })
    })
  }

  maybeGetChecksum(callback) {
    if (this.useMultipart) {
      callback(null, null)
    } else {
      FileChecksum.create(this.file, callback)
    }
  }

  createBlobRecord(checksum, callback) {
    const blobRecord = new BlobRecord(this.file, checksum, this.url, this.customHeaders, this.customAttributes)
    notify(this.delegate, "directUploadWillCreateBlobWithXHR", blobRecord.xhr)
    blobRecord.create(error => callback(error, blobRecord))
  }

  createBlobUpload(blobRecord, callback) {
    const UploadClass = this.useMultipart ? MultipartBlobUpload : BlobUpload
    const upload = new UploadClass(blobRecord)

    notify(this.delegate, "directUploadWillStoreFileWithXHR", upload.xhr)
    upload.create(error => {
      if (error) {
        callback(error)
      } else {
        callback(null, blobRecord.toJSON())
      }
    })
  }
}

function notify(object, methodName, ...messages) {
  if (object && typeof object[methodName] == "function") {
    return object[methodName](...messages)
  }
}
