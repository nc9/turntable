import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UpdateBanner } from "@/components/update-banner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "./router";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
      <UpdateBanner />
    </TooltipProvider>
  </StrictMode>,
);
