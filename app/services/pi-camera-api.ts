export type PiCameraUploadResponse = {
  ok: boolean;
  frame: {
    index: number;
    width: number;
    height: number;
  };
};

type UploadPhotoToPiInput = {
  baseUrl: string;
  photoUri: string;
  filename?: string;
  fieldName?: 'photo' | 'file' | 'frame';
};

export async function uploadPhotoToPiCamera({
  baseUrl,
  photoUri,
  filename,
  fieldName = 'photo',
}: UploadPhotoToPiInput): Promise<PiCameraUploadResponse> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const formData = new FormData();
  const file = {
    uri: photoUri,
    name: filename ?? `pi-frame-${Date.now()}.jpg`,
    type: 'image/jpeg',
  };

  formData.append(fieldName, file as never);

  const response = await fetch(`${normalizedBaseUrl}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Pi camera upload failed with ${response.status}`);
  }

  return (await response.json()) as PiCameraUploadResponse;
}
