#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEB_PORT="${CLIENT_WEB_PORT:-8081}"
WEB_PID="${WEB_PID:-}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"

fail() {
  printf 'WEB HEALTH CHECK FAILED: %s\n' "$*" >&2
  exit 1
}

if [[ -z "${WEB_PID}" || ! "${WEB_PID}" =~ ^[0-9]+$ ]] || ! kill -0 "${WEB_PID}" 2>/dev/null; then
  fail "web-server process is not alive (WEB_PID=${WEB_PID:-unset})"
fi

if ! ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q LISTEN; then
  fail "TCP port ${WEB_PORT} is not listening"
fi

html_file="$(mktemp)"
trap 'rm -f "${html_file}"' EXIT
curl --fail --silent --show-error "${WEB_URL}/" -o "${html_file}" || fail "GET ${WEB_URL}/ did not return 200"
if ! grep -q '<!DOCTYPE html>' "${html_file}" || ! grep -q 'id="root"' "${html_file}"; then
  fail "GET ${WEB_URL}/ returned non-application HTML"
fi

bundle_path="$(grep -oE '<script[^>]+src="[^"]+\.js[^"]*"' "${html_file}" | head -n 1 | sed -E 's/.*src="([^"]+)".*/\1/')"
[[ -n "${bundle_path}" ]] || fail "application HTML does not reference a JavaScript bundle"
curl --fail --silent --show-error "${WEB_URL}${bundle_path}" -o /dev/null || fail "GET ${WEB_URL}${bundle_path} did not return 200"

(
  cd "${LAB_DIR}"
  WEB_URL="${WEB_URL}" timeout 30 node -e '
const { chromium } = require("@playwright/test");
(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    const response = await page.goto(process.env.WEB_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (!response || response.status() !== 200) throw new Error(`page.goto returned ${response ? response.status() : "no response"}`);
    await page.getByText("agenticRemote", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await browser?.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
' 
) || fail "real Playwright page.goto(${WEB_URL}/) did not render application content"

printf 'WEB HEALTH CHECK PASSED: pid=%s port=%s html=200 bundle=200 page.goto=200\n' "${WEB_PID}" "${WEB_PORT}"
