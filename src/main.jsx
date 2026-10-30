import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/cairo/400.css";
import "@fontsource/cairo/600.css";
import "@fontsource/cairo/700.css";
import "@fontsource/cairo/900.css";
import "@fontsource/fredoka/600.css";
import "@fontsource/fredoka/700.css";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
