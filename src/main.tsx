import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ImagePreviewProvider } from "./ImagePreview";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ImagePreviewProvider><App /></ImagePreviewProvider>
  </StrictMode>,
);
