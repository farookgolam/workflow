// Opening a PDF manual. They are for signed-in people only, and a new tab cannot send the sign-in token, so the
// server first hands out a short-lived link to the one manual (see server/src/help/routes.ts).
// The tab is opened straight away, inside the click, so pop-up blockers allow it; the link is filled in after.
export async function openManual(getLink: () => Promise<{ url: string }>): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const { url } = await getLink();
    if (!tab) return void window.location.assign(url); // pop-ups blocked: open it here instead
    tab.opener = null;
    tab.location.replace(url);
  } catch {
    tab?.close();
    window.alert('The manual could not be opened. Sign in again and try once more.');
  }
}
