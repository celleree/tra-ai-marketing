#!/usr/bin/env bash
set -euo pipefail

readonly FFMPEG_VERSION='7.0.2'
readonly FFMPEG_TAG='n7.0.2'
readonly FFMPEG_SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
readonly FFMPEG_SOURCE_SHA256='8646515b638a3ad303e23af6a3587734447cb8fc0a0c064ecdb8e95c4fd8b389'
readonly FFMPEG_SIGNING_FINGERPRINT='FCF986EA15E6E293A5644F10B4322F04D67658D8'

target_key="${1:?Usage: $0 <target-key>}"
output_dir="${2:?Usage: $0 <target-key> <output-dir>}"
case "$target_key" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) executable='ffmpeg' ;;
  win32-x64) executable='ffmpeg.exe' ;;
  *) echo "Unsupported target: $target_key" >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"

curl --fail --location --silent --show-error -o "$work_dir/ffmpeg.tar.xz" "$FFMPEG_SOURCE_URL"
curl --fail --location --silent --show-error -o "$work_dir/ffmpeg.tar.xz.asc" "${FFMPEG_SOURCE_URL}.asc"
gpg --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys "$FFMPEG_SIGNING_FINGERPRINT"
gpg --batch --verify "$work_dir/ffmpeg.tar.xz.asc" "$work_dir/ffmpeg.tar.xz"
if [[ "$(sha256 "$work_dir/ffmpeg.tar.xz")" != "$FFMPEG_SOURCE_SHA256" ]]; then
  echo 'FFmpeg source SHA-256 does not match the pinned FFmpeg 7.0.2 archive.' >&2
  exit 1
fi

tar -xJf "$work_dir/ffmpeg.tar.xz" -C "$work_dir"
source_dir="$work_dir/ffmpeg-${FFMPEG_VERSION}"
test "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)" = ''

configure_args=(
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug
  --disable-programs --disable-shared --enable-static --enable-ffmpeg
  --enable-avcodec --enable-avformat --enable-avfilter --enable-swscale
  --enable-protocol=file,pipe --enable-demuxer=mov
  --enable-parser=h264,hevc,mpeg4video
  --enable-decoder=h264,hevc,mpeg4,mjpeg,prores
  --enable-filter=fps,select,scale,showinfo,format
  --enable-encoder=mjpeg --enable-muxer=image2,null
)
if [[ "$target_key" == 'win32-x64' ]]; then configure_args+=(--target-os=mingw32 --arch=x86_64); fi

(
  cd "$source_dir"
  ./configure "${configure_args[@]}"
  make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
  cp "ffmpeg${executable#ffmpeg}" "$output_dir/$executable"
  ./ffmpeg -version > "$output_dir/${target_key}.version.txt"
  ./ffmpeg -buildconf > "$output_dir/${target_key}.buildconf.txt"
  ./ffmpeg -L > "$output_dir/${target_key}.license-check.txt"
)

grep -q "ffmpeg version ${FFMPEG_VERSION}" "$output_dir/${target_key}.version.txt"
grep -q -- '--disable-nonfree' "$output_dir/${target_key}.buildconf.txt" && { echo 'Nonfree build is not allowed.' >&2; exit 1; }
grep -q -- '--enable-nonfree' "$output_dir/${target_key}.buildconf.txt" && { echo 'Nonfree build is not allowed.' >&2; exit 1; }
grep -q 'GNU Lesser General Public License' "$output_dir/${target_key}.license-check.txt"

cp "$source_dir/COPYING.LGPLv2.1" "$output_dir/${target_key}.LICENSE"
gzip -n -c "$output_dir/$executable" > "$output_dir/ffmpeg-${target_key}.gz"
rm "$output_dir/$executable"

cat > "$output_dir/${target_key}.provenance.json" <<EOF
{"ffmpegVersion":"${FFMPEG_VERSION}","ffmpegTag":"${FFMPEG_TAG}","sourceUrl":"${FFMPEG_SOURCE_URL}","sourceSha256":"$(sha256 "$work_dir/ffmpeg.tar.xz")","target":"${target_key}","configureArgs":$(printf '%s\n' "${configure_args[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split("\n"))))'),"binarySha256":"$(gzip -cd "$output_dir/ffmpeg-${target_key}.gz" | (command -v sha256sum >/dev/null && sha256sum || shasum -a 256) | awk '{print $1}')","compressedSha256":"$(sha256 "$output_dir/ffmpeg-${target_key}.gz")"}
EOF
