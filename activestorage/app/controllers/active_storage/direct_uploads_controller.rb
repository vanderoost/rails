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
    def blob_args
      params.expect(blob: [:filename, :byte_size, :checksum, :content_type, :key_prefix, :keep_filename, metadata: {}]).to_h.symbolize_keys
    end

    def complete_multipart_args
      params.expect(blob: [:upload_id, parts: [[:etag, :part_number]]]).to_h.deep_symbolize_keys
    end

    def direct_upload_json(blob)
      if blob.checksum.present?
        single_part_direct_upload_json(blob)
      else
        multipart_direct_upload_json(blob)
      end
    end

    def single_part_direct_upload_json(blob)
      blob.as_json(root: false, methods: :signed_id).merge(direct_upload: {
        url: blob.service_url_for_direct_upload,
        headers: blob.service_headers_for_direct_upload
      })
    end

    def multipart_direct_upload_json(blob)
      upload_id = blob.service_initiate_multipart_upload
      part_count = [(Math.sqrt(blob.byte_size / 1.megabyte) / 3).ceil, 1].max
      logger.debug "Multipart with #{part_count} parts"
      part_size = blob.byte_size.fdiv(part_count).ceil
      logger.debug "Parts of size #{part_size}"

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
