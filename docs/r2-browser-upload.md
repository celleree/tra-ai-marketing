# Cloudflare R2 browser upload setup

Production source-image uploads use a short-lived presigned PUT URL so the image goes directly from the browser to R2 instead of passing through a Vercel Function.

The R2 bucket must allow CORS for the live app origin. In Cloudflare R2 → bucket → Settings → CORS Policy, use this shape and replace the origin with the exact live app origin (no trailing slash):

```json
[
  {
    "AllowedOrigins": ["https://YOUR-LIVE-APP-ORIGIN"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

If preview deployments also need direct uploads, add only the preview origins that should be allowed. Avoid `*` for the production bucket.

The application signs each upload for five minutes and signs the requested `Content-Type`. R2 credentials remain server-only.
