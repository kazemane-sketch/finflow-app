import { Toaster as SonnerToaster } from "sonner"

export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      toastOptions={{
        className: "font-sans",
        duration: 4000,
      }}
    />
  )
}
