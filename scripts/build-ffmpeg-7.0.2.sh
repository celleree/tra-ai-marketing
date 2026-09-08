#!/usr/bin/env bash
set -euo pipefail

readonly FFMPEG_VERSION='7.0.2'
readonly FFMPEG_TAG='n7.0.2'
readonly FFMPEG_SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
readonly FFMPEG_SOURCE_SHA256='8646515b638a3ad303e23af6a3587734447cb8fc0a0c064ecdb8e95c4fd8b389'
readonly FFMPEG_SIGNING_FINGERPRINT='FCF986EA15E6E293A5644F10B4322F04D67658D8'

target_key="${1:?Usage: $0 <target-key>}"
output_dir="${2:?Usage: $0 <target-key> <output-dir>}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
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

export GNUPGHOME="$work_dir/gnupg"
mkdir "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

key_file="$work_dir/ffmpeg-release-signing-key.asc"
cat > "$key_file" <<'EOF'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQENBE22rV0BCAC3DzRmA2XlhrqYv9HKoEvNHHf+PzosmCTHmYhWHDqvBxPkSvCl
ipkbvJ4pBnVvcX6mW5QyKhspHm5j1X5ibe9Bt9/chS/obnIobmvF8shSUgjQ0qRW
9c1aWOjvT26SxYQ1y9TmYCFwixeydGFHYKjAim+evGUccni5KMlfPoT3VTPtim78
ufkr3E9Nco/Mobn/8APO0NmLEGWAM6ln/8J/c9h6a1QKnQyBqWfT0YnAaebafFaZ
YwOtRdDG54VbJ4xwcHbCj5cKhTABk/QtBzDvnW4bG+uSpqdHbFZEY2JpURDuj/T3
NudKQGzn0bYNpY1XY2l0pqs/btKHnBW0fVMjABEBAAG0NEZGbXBlZyByZWxlYXNl
IHNpZ25pbmcga2V5IDxmZm1wZWctZGV2ZWxAZmZtcGVnLm9yZz6JATgEEwECACIF
Ak22rV0CGwMGCwkIBwMCBhUIAgkKCwQWAgMBAh4BAheAAAoJELQyLwTWdljYKxUH
/1fqzl7SKie2g4t4PJbqUbkLuMsC+CP6gp0dcVZOHkuUYAoD3PM3iVxpLBVyKIXI
g7wMSTAtlIcYnzhWIpnoCBes6/O2Mrq6xHgGeTp6CDcm3LmmSYR1f5KdD8KUaA+l
c/M/1fEnwrSs/UGDk6R6iUmbqwxPsbozlOvmUHOLbDZBnKrk9XfAJdUhAuFACrSA
T+KF1jniz0OfNGd23SaHWRCphoRW9pXDc5FfkdaueBUvBvGv19ZNcDhcxT3/u6z2
DaUFC0rLWqk8obo951jVvi/zOhB94Pw6u1SLvcTq3V1q5URWJtgSbpih9VRqxUbQ
NbXduKGzbHz6Vwpkupz4JRe5AQ0ETbatXQEIANjYrygJi/fn1nlSg5Mz0l9KHDm4
yfWtaOrXUjJcyiGe4G0XXJLGh45qxJ0DOKzi9id+9W4jby+kKuzG9O6Vn0iDeODO
aOGnz4ua7Vu6d0AbYfNXZPWge/GCodo/ZD/qri1tPkLmRtT/sniahwy6LruPNHfF
SRoNIjwbcD/IL+EbY1pL1/IFSzEAA1ZZamgmHgB7o9pwDIkK6HuvHMR/Y5MsoMfV
fWV3ZGtA6v9z51CvnHsHPsADRSnUp7aYtR412SiAO4XodMLTA92L3LxgYhI4ma7D
XZ8jgKg4JkKO+DXmoU63HtRdq/HZjeXJKk1JGJF3zCvP3DyIzZ8LWIjN8t0AEQEA
AYkBHwQYAQIACQUCTbatXQIbDAAKCRC0Mi8E1nZY2LS8B/0bMoUAl4X9D0WQbL4l
U0czCIOKOsvbHpIxivjCnOQxU23+PV5WZdoCCpSuAHGv+2OHzhNrij++P9BNTJeQ
skxdS9FH4MZwy1IRSPrxegSxbCUpBI1rd0Zf7qb9BNPrHPTueWFV1uExOSB2Apsv
WrKo2D8mR0uZAPYfYl2ToFVoa5PR7/+ii9WiJr/flF6qm7hoLpI5Bm4VcZh2GPsJ
9Vo/8x/qOGwtdWHqBykYloKsrwD4U69rjn+d9feLoPBRgoVroXWQttt0sUnyoudz
+x8ETJgPoNK3kQoDagApj4qAt83Ayac3HzNIuEJ7LdvfINIOprujnJ9vH4n04XLg
I4EZ
=Rjbw
-----END PGP PUBLIC KEY BLOCK-----
EOF
gpg --batch --import "$key_file"
imported_fingerprint="$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
if [[ "$imported_fingerprint" != "$FFMPEG_SIGNING_FINGERPRINT" ]]; then
  echo 'Pinned FFmpeg release signing key fingerprint does not match.' >&2
  exit 1
fi

curl --fail --location --silent --show-error -o "$work_dir/ffmpeg.tar.xz" "$FFMPEG_SOURCE_URL"
curl --fail --location --silent --show-error -o "$work_dir/ffmpeg.tar.xz.asc" "${FFMPEG_SOURCE_URL}.asc"
gpg --batch --verify "$work_dir/ffmpeg.tar.xz.asc" "$work_dir/ffmpeg.tar.xz"
if [[ "$(sha256 "$work_dir/ffmpeg.tar.xz")" != "$FFMPEG_SOURCE_SHA256" ]]; then
  echo 'FFmpeg source SHA-256 does not match the pinned FFmpeg 7.0.2 archive.' >&2
  exit 1
fi

# Publish one copy of the exact verified corresponding source with the release.
if [[ "$target_key" == 'linux-x64' ]]; then
  cp "$work_dir/ffmpeg.tar.xz" "$output_dir/ffmpeg-${FFMPEG_VERSION}.tar.xz"
fi

tar -xJf "$work_dir/ffmpeg.tar.xz" -C "$work_dir"
source_dir="$work_dir/ffmpeg-${FFMPEG_VERSION}"
test "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)" = ''

configure_args=(
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug
  --disable-programs --disable-shared --enable-static --enable-ffmpeg
  --enable-avcodec --enable-avformat --enable-avfilter --enable-swscale --enable-zlib
  --enable-protocol=file,pipe --enable-demuxer=mov
  --enable-parser=h264,hevc,mpeg4video
  --enable-decoder=h264,hevc,mpeg4,mjpeg,prores
  --enable-filter=fps,select,scale,showinfo,format
  --enable-encoder=mjpeg,png,wrapped_avframe --enable-muxer=image2,image2pipe,null
)
if [[ "$target_key" == linux-* ]]; then
  configure_args+=(--extra-ldflags=-static)
elif [[ "$target_key" == 'win32-x64' ]]; then
  configure_args+=(--target-os=mingw32 --arch=x86_64 --extra-ldflags=-static)
fi

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
grep -q 'GNU Lesser General Public' "$output_dir/${target_key}.license-check.txt"
grep -q 'version 2.1 of the License' "$output_dir/${target_key}.license-check.txt"

if [[ "$target_key" == 'win32-x64' ]] && objdump -p "$output_dir/$executable" | grep -Eiq 'DLL Name:[[:space:]]+zlib1\.dll'; then
  echo 'Windows FFmpeg must not depend on the MSYS2 zlib1.dll runtime.' >&2
  exit 1
fi

if [[ "$target_key" == linux-* ]]; then
  case "$target_key" in
    linux-x64) expected_machine='Advanced Micro Devices X86-64' ;;
    linux-arm64) expected_machine='AArch64' ;;
  esac
  actual_machine="$(readelf -h "$output_dir/$executable" | awk -F: '/^[[:space:]]*Machine:/ { sub(/^[[:space:]]*/, "", $2); print $2 }')"
  if [[ "$actual_machine" != "$expected_machine" ]]; then
    echo "Linux FFmpeg ELF machine is $actual_machine; expected $expected_machine." >&2
    exit 1
  fi
  if readelf -lW "$output_dir/$executable" | awk '$1 == "INTERP" { found = 1 } END { exit found ? 0 : 1 }'; then
    echo 'Linux FFmpeg must not contain an ELF interpreter program header.' >&2
    exit 1
  fi
  if readelf -dW "$output_dir/$executable" | grep -q '(NEEDED)'; then
    echo 'Linux FFmpeg must not contain dynamic ELF dependencies.' >&2
    exit 1
  fi
  node "$script_dir/smoke-ffmpeg-reordered.mjs" "$output_dir/$executable"
fi

cp "$source_dir/COPYING.LGPLv2.1" "$output_dir/${target_key}.LICENSE"
gzip -n -c "$output_dir/$executable" > "$output_dir/ffmpeg-${target_key}.gz"
rm "$output_dir/$executable"

cat > "$output_dir/${target_key}.provenance.json" <<EOF
{"ffmpegVersion":"${FFMPEG_VERSION}","ffmpegTag":"${FFMPEG_TAG}","sourceUrl":"${FFMPEG_SOURCE_URL}","sourceSha256":"$(sha256 "$work_dir/ffmpeg.tar.xz")","target":"${target_key}","configureArgs":$(printf '%s\n' "${configure_args[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split("\n"))))'),"binarySha256":"$(gzip -cd "$output_dir/ffmpeg-${target_key}.gz" | (command -v sha256sum >/dev/null && sha256sum || shasum -a 256) | awk '{print $1}')","compressedSha256":"$(sha256 "$output_dir/ffmpeg-${target_key}.gz")"}
EOF
