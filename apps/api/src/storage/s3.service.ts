import { Injectable } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

/** Long enough for CI to push a large video, short enough to be useless if leaked. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** A browser only needs the URL for as long as it takes to render the page. */
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  readonly bucket: string;

  constructor() {
    const config = env();
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      // MinIO serves buckets as a path rather than a subdomain, and so do most
      // S3-compatible stores that are not AWS.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  /**
   * Artifacts are addressed by content hash under the run that produced them.
   *
   * Content addressing makes an upload retry idempotent for free: the same
   * bytes land on the same key, so a retried CI job overwrites rather than
   * accumulating a second copy of a 40MB video.
   */
  key(projectId: string, runId: string, sha256: string, kind: string, extension: string): string {
    return `${projectId}/${runId}/${kind}/${sha256}${extension}`;
  }

  presignUpload(key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  }

  /**
   * Access control happens here, when the URL is issued — the caller has
   * already passed the RBAC guard. The bucket itself stays private, so a key
   * on its own is not enough to read anything.
   */
  presignDownload(key: string, filename?: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(filename ? { ResponseContentDisposition: `inline; filename="${filename}"` } : {}),
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}
