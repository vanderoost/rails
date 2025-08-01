import { FileChecksum } from "./file_checksum"
import { BlobRecord } from "./blob_record"
import { BlobUpload } from "./blob_upload"
import { MultipartBlobUpload } from "./multipart_blob_upload"

let id = 0

export class DirectUpload {
  constructor(file, url, delegate, customHeaders = {}) {
    this.id = ++id
    this.file = file
    this.url = url
    this.delegate = delegate
    this.customHeaders = customHeaders
  }

  create(callback) {
    FileChecksum.create(this.file, (error, checksum) => {
      if (error) {
        callback(error)
        return
      }

      const blobRecord = new BlobRecord(this.file, checksum, this.url, this.customHeaders)
      notify(this.delegate, "directUploadWillCreateBlobWithXHR", blobRecord.xhr)

      console.debug("blob before create:", blobRecord.toJSON())
      blobRecord.create(error => { // This sends a request to the server
        if (error) {
          callback(error)
        } else {
          console.debug("blob after create:", blobRecord.toJSON())
          const { directUploadData } = blobRecord

          if (directUploadData.upload_id) {
            // Multipart upload
            const multipartUpload = new MultipartBlobUpload(blobRecord)
            notify(this.delegate, "directUploadWillStoreFileWithXHR", multipartUpload.xhr)
            multipartUpload.create(error => {
              if (error) {
                callback(error)
              } else {
                callback(null, blobRecord.toJSON())
              }
            })
          } else {
            // Regular upload
            const blobUpload = new BlobUpload(blobRecord)
            notify(this.delegate, "directUploadWillStoreFileWithXHR", blobUpload.xhr)
            blobUpload.create(error => {
              if (error) {
                callback(error)
              } else {
                callback(null, blobRecord.toJSON())
              }
            })
          }
        }
      })
    })
  }
}

function notify(object, methodName, ...messages) {
  if (object && typeof object[methodName] == "function") {
    return object[methodName](...messages)
  }
}
