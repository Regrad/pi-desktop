import { t } from "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ImagePreviewProvider } from "./ImagePreview";
import "./styles.css";
import { installWebApi } from "./web-api";

void installWebApi().then(ready => {
  if (!ready) return;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ImagePreviewProvider><App /></ImagePreviewProvider>
    </StrictMode>,
  );
}).catch(() => { document.body.textContent = t("Не удалось подключиться к Pi Desktop. Обновите страницу."); });
