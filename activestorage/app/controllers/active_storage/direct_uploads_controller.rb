# frozen_string_literal: true

# Creates a new blob on the server side in anticipation of a direct-to-service upload from the client side.
# When the client-side upload is completed, the signed_blob_id can be submitted as part of the form to reference
# the blob that was created up front.
class ActiveStorage::DirectUploadsController < ActiveStorage::BaseController
  def create
    blob = ActiveStorage::Blob.create_before_direct_upload!(**blob_args)
    render json: direct_upload_json(blob)
  end

  def update
    blob = ActiveStorage::Blob.find(params[:id])
    blob.service_complete_multipart_for_direct_upload(**complete_multipart_args)
    head :ok
  end

  private
    # MAXIMUM_UPLOAD_PARTS_COUNT = 10000
    MAXIMUM_UPLOAD_PARTS_COUNT = 20
    MINIMUM_UPLOAD_PART_SIZE   = 5.megabytes

    def blob_args
      params.expect(blob: [:filename, :byte_size, :checksum, :content_type, metadata: {}]).to_h.symbolize_keys
    end

    def complete_multipart_args
      permitted = params.permit(:upload_id, parts: [:etag, :part_number])

      {
        upload_id: permitted[:upload_id],
        parts: permitted[:parts].map(&:to_h).map(&:symbolize_keys)
      }
    end

    def direct_upload_json(blob)
      if blob.service.respond_to?(:multipart_upload_threshold)
        logger.debug "Service #{blob.service.class} supports multipart uploads"
        if blob.byte_size >= blob.service.multipart_upload_threshold
          return multipart_direct_upload_json(blob)
        end
      end
      standard_direct_upload_json(blob)
    end

    def standard_direct_upload_json(blob)
      logger.debug "Using standard direct upload :/"
      blob.as_json(root: false, methods: :signed_id).merge(direct_upload: {
        url: blob.service_url_for_direct_upload,
        headers: blob.service_headers_for_direct_upload
      })
    end

    def multipart_direct_upload_json(blob)
      upload_id = blob.service_initiate_multipart_upload
      part_size = [ blob.byte_size.fdiv(MAXIMUM_UPLOAD_PARTS_COUNT).ceil, MINIMUM_UPLOAD_PART_SIZE ].max
      part_count = blob.byte_size.fdiv(part_size).ceil
      logger.debug "Using multipart upload :D with #{part_count} parts of size #{part_size}"

      part_urls = (1..part_count).map do |part_number|
        {
          part_number: part_number,
          url: blob.service_part_url_for_direct_upload(
            upload_id: upload_id,
            part_number: part_number
          )
        }
      end

      blob.as_json(root: false, methods: :signed_id).merge(direct_upload: {
        upload_id: upload_id,
        part_size: part_size,
        part_urls: part_urls
      })
    end
end
