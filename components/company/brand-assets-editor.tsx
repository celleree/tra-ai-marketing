'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import {
  extractLogoPalette,
  formatBrandColors,
  parseBrandColors,
} from '@/lib/company/brand-colors';
import {
  MAX_BRAND_FONTS,
  brandFontLabel,
  parseBrandFontAssets,
  serializeBrandFontAssets,
  type BrandFontAsset,
} from '@/lib/company/brand-fonts';
import {
  analyzeBrandFontSpecimen,
  createBrandFontSpecimen,
  loadBrandFontFace,
  removeBrandFontFile,
  uploadBrandFont,
} from '@/lib/company/font-client';
import type { MediaAsset } from '@/lib/media/types';
import styles from './brand-assets.module.css';

interface BrandAssetsEditorProps {
  logo: string;
  brandColors: string;
  fonts: string;
  onChange: (key: 'logo' | 'brandColors' | 'fonts', value: string) => void;
}

function FontPreview({ asset }: { asset: BrandFontAsset }) {
  const [family, setFamily] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadBrandFontFace(asset)
      .then((nextFamily) => {
        if (!cancelled) setFamily(nextFamily);
      })
      .catch(() => {
        if (!cancelled) setFamily('');
      });
    return () => {
      cancelled = true;
    };
  }, [asset]);

  return (
    <div className={styles.fontPreview} style={family ? { fontFamily: `"${family}"` } : undefined}>
      Tax Relief Advocates
    </div>
  );
}

export function BrandAssetsEditor({
  logo,
  brandColors,
  fonts,
  onChange,
}: BrandAssetsEditorProps) {
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [logoMessage, setLogoMessage] = useState('');
  const [isUploadingFont, setIsUploadingFont] = useState(false);
  const [fontMessage, setFontMessage] = useState('');

  const colors = useMemo(() => parseBrandColors(brandColors), [brandColors]);
  const fontAssets = useMemo(() => parseBrandFontAssets(fonts), [fonts]);

  const handleLogoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || isUploadingLogo) return;

    setIsUploadingLogo(true);
    setLogoMessage('');

    try {
      const palettePromise = extractLogoPalette(file).catch(() => [] as string[]);
      const formData = new FormData();
      formData.set('file', file);
      const response = await fetch('/api/media/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = (await response.json()) as MediaAsset & { error?: string };
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || 'The logo could not be uploaded.');
      }

      const palette = await palettePromise;
      onChange('logo', payload.url);
      if (palette.length) {
        onChange('brandColors', formatBrandColors(palette));
        setLogoMessage(`Logo uploaded. ${palette.length} brand color${palette.length === 1 ? '' : 's'} applied automatically.`);
      } else {
        setLogoMessage('Logo uploaded. Colors could not be detected automatically, so the existing palette was preserved.');
      }
    } catch (error) {
      setLogoMessage(error instanceof Error ? error.message : 'The logo could not be uploaded.');
    } finally {
      setIsUploadingLogo(false);
      input.value = '';
    }
  };

  const handleFontUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || isUploadingFont) return;
    if (fontAssets.length >= MAX_BRAND_FONTS) {
      setFontMessage(`You can save up to ${MAX_BRAND_FONTS} brand font files.`);
      input.value = '';
      return;
    }

    setIsUploadingFont(true);
    setFontMessage('');

    try {
      const uploaded = await uploadBrandFont(file);
      let nextAsset = uploaded;

      try {
        const specimen = await createBrandFontSpecimen(file, uploaded);
        let styleDescription = '';
        try {
          styleDescription = await analyzeBrandFontSpecimen(specimen.id);
        } catch {
          // The exact font file and specimen remain saved even if AI analysis is unavailable.
        }
        nextAsset = {
          ...uploaded,
          specimenMediaId: specimen.id,
          specimenUrl: specimen.url,
          ...(styleDescription ? { styleDescription } : {}),
        };
      } catch {
        // Keep the actual font file even if the visual specimen cannot be generated.
      }

      onChange('fonts', serializeBrandFontAssets([...fontAssets, nextAsset]));
      setFontMessage(
        nextAsset.styleDescription
          ? 'Font saved, analyzed, and added to creative typography guidance.'
          : nextAsset.specimenMediaId
            ? 'Font saved with an exact visual specimen for brand reference.'
            : 'Font saved. Re-upload if you want a visual typography reference generated.'
      );
    } catch (error) {
      setFontMessage(error instanceof Error ? error.message : 'The font could not be uploaded.');
    } finally {
      setIsUploadingFont(false);
      input.value = '';
    }
  };

  const removeFont = async (asset: BrandFontAsset) => {
    onChange(
      'fonts',
      serializeBrandFontAssets(fontAssets.filter((font) => font.id !== asset.id))
    );
    setFontMessage('');
    try {
      await removeBrandFontFile(asset);
    } catch {
      // The saved profile is authoritative; an already-missing file needs no extra UI error.
    }
  };

  return (
    <>
      <div className={styles.assetField}>
        <div className={styles.fieldHeading}>
          <div>
            <strong>Logo</strong>
            <span>Upload the approved logo. The exact asset is applied to generated ads.</span>
          </div>
        </div>
        <div className={styles.logoRow}>
          <div className={styles.logoPreview}>
            {logo ? <img src={logo} alt="Company logo preview" /> : <span>No logo uploaded</span>}
          </div>
          <div className={styles.actions}>
            <label className={styles.uploadButton}>
              {isUploadingLogo ? 'Uploading…' : logo ? 'Change logo' : 'Upload logo'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={isUploadingLogo}
                onChange={handleLogoUpload}
              />
            </label>
            {logo ? (
              <button type="button" className={styles.secondaryButton} onClick={() => onChange('logo', '')}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
        {logoMessage ? <small className={styles.message}>{logoMessage}</small> : null}
      </div>

      <div className={styles.assetField}>
        <div className={styles.fieldHeading}>
          <div>
            <strong>Brand colors</strong>
            <span>Detected from the uploaded logo automatically. You can still edit the palette.</span>
          </div>
        </div>
        {colors.length ? (
          <div className={styles.swatches} aria-label="Saved brand colors">
            {colors.map((color) => (
              <div key={color} className={styles.swatchItem}>
                <span className={styles.swatch} style={{ backgroundColor: color }} />
                <code>{color}</code>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.emptyText}>Upload a logo to detect its main colors.</p>
        )}
        <textarea
          className={styles.colorInput}
          rows={3}
          value={brandColors}
          placeholder="Primary: #123456"
          onChange={(event) => onChange('brandColors', event.target.value)}
        />
      </div>

      <div className={styles.assetField}>
        <div className={styles.fieldHeading}>
          <div>
            <strong>Fonts</strong>
            <span>Upload actual WOFF2, WOFF, TTF, or OTF brand fonts. The app saves the file, renders it exactly for preview, and uses an analyzed specimen as creative typography guidance.</span>
          </div>
          <span className={styles.count}>{fontAssets.length}/{MAX_BRAND_FONTS}</span>
        </div>

        {fontAssets.length ? (
          <div className={styles.fontList}>
            {fontAssets.map((asset) => (
              <div key={asset.id} className={styles.fontCard}>
                <div className={styles.fontMeta}>
                  <strong>{brandFontLabel(asset)}</strong>
                  <span>{asset.originalName}</span>
                </div>
                <FontPreview asset={asset} />
                {asset.styleDescription ? (
                  <p className={styles.emptyText}>{asset.styleDescription}</p>
                ) : null}
                <div className={styles.fontStatus}>
                  <span>{asset.styleDescription ? 'Creative guidance ready' : asset.specimenMediaId ? 'Visual specimen saved' : 'Font file saved'}</span>
                  <button type="button" onClick={() => removeFont(asset)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.emptyText}>No font files uploaded yet.</p>
        )}

        <label className={styles.uploadButton}>
          {isUploadingFont ? 'Uploading font…' : 'Upload font'}
          <input
            type="file"
            accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
            disabled={isUploadingFont || fontAssets.length >= MAX_BRAND_FONTS}
            onChange={handleFontUpload}
          />
        </label>
        <small className={styles.help}>Maximum 4 MB per font file.</small>
        {fontMessage ? <small className={styles.message}>{fontMessage}</small> : null}
      </div>
    </>
  );
}
