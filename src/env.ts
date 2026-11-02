export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  DRIVE_ROOT_ID?: string;
  MAIL_FORWARD_ADDRESS?: string; // Plus-Adresse, an die iCloud weiterleitet (Secret)
  MAIL_SEEN?: KVNamespace; // verarbeitete Gmail-IDs
}
