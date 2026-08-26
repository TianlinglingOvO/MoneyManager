#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
windows_env="${SMB_ENV_PATH:-$project_dir/.env}"
openclaw_dir="$HOME/.openclaw"
openclaw_env="$openclaw_dir/.env"

if [[ ! -f "$windows_env" ]]; then
  printf '找不到 SMB 本机配置：%s\n' "$windows_env" >&2
  exit 1
fi

money_manager_token="$(awk -F= '$1 == "MCP_API_TOKEN" { sub(/^[^=]*=/, ""); print }' "$windows_env" | tail -n 1)"
if [[ -z "$money_manager_token" ]]; then
  printf 'SMB .env 中缺少 MCP_API_TOKEN。\n' >&2
  exit 1
fi

printf '请粘贴 Cloudflare Client ID 的值，然后按 Enter：\n> '
IFS= read -r cloudflare_client_id
printf '请粘贴 Cloudflare Client Secret 的值，然后按 Enter（输入不会显示）：\n> '
IFS= read -rs cloudflare_client_secret
printf '\n'

if [[ -z "$cloudflare_client_id" || -z "$cloudflare_client_secret" ]]; then
  printf 'Client ID 和 Client Secret 都不能为空。\n' >&2
  exit 1
fi

mkdir -p "$openclaw_dir"
touch "$openclaw_env"
chmod 600 "$openclaw_env"

temporary_env="$(mktemp "$openclaw_dir/.env.tmp.XXXXXX")"
cleanup() {
  rm -f "$temporary_env"
  unset money_manager_token cloudflare_client_id cloudflare_client_secret
}
trap cleanup EXIT

awk '!/^(MONEY_MANAGER_MCP_TOKEN|MONEY_CF_ACCESS_CLIENT_ID|MONEY_CF_ACCESS_CLIENT_SECRET)=/' "$openclaw_env" > "$temporary_env"
printf '%s=%s\n' 'MONEY_MANAGER_MCP_TOKEN' "$money_manager_token" >> "$temporary_env"
printf '%s=%s\n' 'MONEY_CF_ACCESS_CLIENT_ID' "$cloudflare_client_id" >> "$temporary_env"
printf '%s=%s\n' 'MONEY_CF_ACCESS_CLIENT_SECRET' "$cloudflare_client_secret" >> "$temporary_env"
chmod 600 "$temporary_env"
mv -f "$temporary_env" "$openclaw_env"

trap - EXIT
unset money_manager_token cloudflare_client_id cloudflare_client_secret
printf '\nOpenClaw 的三个 SMB 凭据已写入 ~/.openclaw/.env。\n'
printf '文件权限已设置为仅当前 WSL 用户可读写。\n'
printf '下一步仍需创建 Cloudflare 的 /mcp Service Auth 应用。\n'
