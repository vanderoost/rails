# frozen_string_literal: true

# Completes a direct multipart upload
class ActiveStorage::CompleteMultipartUploadJob < ActiveStorage::BaseJob
  queue_as { ActiveStorage.queues[:complete_multipart_upload] }

  discard_on ActiveRecord::RecordNotFound
  retry_on ActiveStorage::IntegrityError, attempts: 10, wait: :polynomially_longer

  def perform(blob, upload_id:, parts:)
    meta = blob.metadata || {}
    return if meta.key?("multipart_completed_at")

    blob.service_complete_multipart_upload(upload_id: upload_id, parts: parts)

    blob.update(metadata: meta.merge(
      "multipart_completed_at" => Time.current
    ).except("multipart_completion_pending"))
  end
end
