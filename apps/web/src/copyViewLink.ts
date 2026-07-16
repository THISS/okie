export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export async function copyViewLink(url: string, clipboard: ClipboardWriter | undefined) {
  if (!clipboard) throw new Error('Clipboard access is unavailable.');
  await clipboard.writeText(url);
}
