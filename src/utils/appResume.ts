export const APP_RESUME_EVENT = "devhaven:app-resume";

export function dispatchAppResumeEvent() {
  window.dispatchEvent(new CustomEvent(APP_RESUME_EVENT));
  window.dispatchEvent(new Event("resize"));
}
