import type { ScreenCaptureIssue } from "../types";

export function screenCaptureIssueTitle(issue: ScreenCaptureIssue) {
  return { "access-unconfirmed": "Screen Recording access is not confirmed", "no-windows": "No eligible windows are available", "no-displays": "No displays are available" }[issue.reason];
}
