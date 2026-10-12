// Load libvips only when an image is actually pasted or previewed.
export async function imageProcessor() {
  const { default: sharp } = await import('sharp');
  // Cache limits affect reusable libvips operations, not the image size limits.
  sharp.cache({ memory: 8, files: 0, items: 32 });
  return sharp;
}
