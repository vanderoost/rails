import { DirectUploadController } from "./direct_upload_controller"
import { findElements, dispatchEvent, toArray } from "./helpers"

const inputSelector = "input[type=file][data-direct-upload-url]:not([disabled])"

export class DirectUploadsController {
  constructor(form) {
    this.form = form
    this.inputs = findElements(form, inputSelector).filter(input => input.files.length)
    this.maxConcurrentUploads = 3 // Upload up to 3 files concurrently
  }

  start(callback) {
    const controllers = this.createDirectUploadControllers()
    this.dispatch("start")

    if (controllers.length === 0) {
      callback()
      this.dispatch("end")
      return
    }

    // Upload files concurrently
    this.uploadControllersConcurrently(controllers, callback)
  }

  uploadControllersConcurrently(controllers, callback) {
    console.debug("DirectUploadsController#startNextController")
    
    this.uploadControllersWithConcurrencyLimit(controllers, this.maxConcurrentUploads)
      .then(() => {
        callback()
        this.dispatch("end")
      })
      .catch(error => {
        callback(error)
        this.dispatch("end")
      })
  }

  uploadControllersWithConcurrencyLimit(controllers, limit) {
    return new Promise((resolve, reject) => {
      const results = []
      const executing = []
      let controllerIndex = 0

      const startNextUpload = () => {
        if (controllerIndex >= controllers.length) {
          if (executing.length === 0) {
            resolve()
          }
          return
        }

        const controller = controllers[controllerIndex++]
        const uploadPromise = this.uploadControllerAsync(controller)
        
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

      // Start up to 'limit' concurrent uploads
      for (let i = 0; i < Math.min(limit, controllers.length); i++) {
        startNextUpload()
      }
    })
  }

  uploadControllerAsync(controller) {
    return new Promise((resolve, reject) => {
      controller.start(error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  createDirectUploadControllers() {
    const controllers = []
    this.inputs.forEach(input => {
      toArray(input.files).forEach(file => {
        controllers.push(new DirectUploadController(input, file))
      })
    })
    return controllers
  }

  dispatch(name, detail = {}) {
    return dispatchEvent(this.form, `direct-uploads:${name}`, { detail })
  }
}