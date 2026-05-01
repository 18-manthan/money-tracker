import React from "react";
import { createRoot } from "react-dom/client";
import { ArrowDownCircle, ArrowUpCircle, LogOut, MinusCircle, Plus } from "lucide-react";
import "./styles.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App icons={{ ArrowDownCircle, ArrowUpCircle, LogOut, MinusCircle, Plus }} />
  </React.StrictMode>
);
