// =============================================================================
// Photo Buffer Middleware — Manages multi-page bill photo collection
// =============================================================================

// In-memory buffer tracking (per phone number)
// Key: phone number, Value: { timer, photos: [], expected, confirmed }
const buffers = new Map();

const DEFAULT_TIMER_MS = 15000; // 15 seconds after each photo
const CONFIRMED_TIMER_MS = 5000; // 5 seconds after all photos received

/**
 * Start or reset the photo buffer for a phone number.
 * Called every time a new photo arrives.
 */
export function addPhoto(phone, photoData, photosExpected = null) {
  let buffer = buffers.get(phone);

  if (!buffer) {
    buffer = {
      timer: null,
      photos: [],
      expected: photosExpected || 1,
      confirmed: false,
      timerExpired: false,
    };
    buffers.set(phone, buffer);
  }

  // Update expected count if provided
  if (photosExpected) {
    buffer.expected = photosExpected;
  }

  // Add photo
  buffer.photos.push({
    ...photoData,
    receivedAt: new Date().toISOString(),
  });

  // Clear existing timer
  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  // Set new timer
  const timerMs =
    buffer.photos.length >= buffer.expected
      ? CONFIRMED_TIMER_MS
      : DEFAULT_TIMER_MS;

  return new Promise((resolve) => {
    buffer.timer = setTimeout(() => {
      buffer.timerExpired = true;
      resolve({
        complete: true,
        photoCount: buffer.photos.length,
        expected: buffer.expected,
        allReceived: buffer.photos.length >= buffer.expected,
        photos: buffer.photos,
      });
    }, timerMs);
  });
}

/**
 * Confirm that the user has sent all photos.
 * Called when user explicitly confirms ("sí", "son todas").
 */
export function confirmPhotos(phone) {
  const buffer = buffers.get(phone);
  if (!buffer) return null;

  buffer.confirmed = true;

  // Clear timer and resolve immediately
  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  const result = {
    complete: true,
    photoCount: buffer.photos.length,
    expected: buffer.expected,
    allReceived: true,
    photos: buffer.photos,
  };

  // Clean up buffer
  buffers.delete(phone);

  return result;
}

/**
 * Check if buffer has more photos expected.
 */
export function getBufferStatus(phone) {
  const buffer = buffers.get(phone);
  if (!buffer) return null;

  return {
    photosReceived: buffer.photos.length,
    photosExpected: buffer.expected,
    confirmed: buffer.confirmed,
    timerExpired: buffer.timerExpired,
  };
}

/**
 * Clean up buffer for a phone number.
 */
export function clearBuffer(phone) {
  const buffer = buffers.get(phone);
  if (buffer?.timer) {
    clearTimeout(buffer.timer);
  }
  buffers.delete(phone);
}

export default { addPhoto, confirmPhotos, getBufferStatus, clearBuffer };
