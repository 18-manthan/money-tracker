import React from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CircleDollarSign,
  LogOut,
  Moon,
  MinusCircle,
  Plus,
  Sun,
  Trash2
} from "lucide-react";
import "./styles.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App
      icons={{
        ArrowDownCircle,
        ArrowUpCircle,
        CircleDollarSign,
        LogOut,
        Moon,
        MinusCircle,
        Plus,
        Sun,
        Trash2
      }}
    />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app still works normally if service workers are unavailable on local HTTP.
    });
  });
}
