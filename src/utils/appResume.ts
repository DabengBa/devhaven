export const APP_RESUME_EVENT = "devhaven:app-resume";
export const APP_RESUME_MIN_INACTIVE_MS = 15_000;

export function dispatchAppResumeEvent() {
  window.dispatchEvent(new CustomEvent(APP_RESUME_EVENT));
  window.dispatchEvent(new Event("resize"));
}
