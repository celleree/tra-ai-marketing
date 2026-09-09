type CreativeSourceUploadListener = () => void;

let uploadInFlight = false;
const listeners = new Set<CreativeSourceUploadListener>();

const notify = () => {
  for (const listener of listeners) listener();
};

export const getCreativeSourceUploadInFlight = () => uploadInFlight;

export const subscribeCreativeSourceUploadInFlight = (
  listener: CreativeSourceUploadListener
) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const tryAcquireCreativeSourceUpload = () => {
  if (uploadInFlight) return false;
  uploadInFlight = true;
  notify();
  return true;
};

export const releaseCreativeSourceUpload = () => {
  if (!uploadInFlight) return;
  uploadInFlight = false;
  notify();
};
