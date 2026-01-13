import { useState } from "react";
import { Button } from "./ui/button";
import QRModal from "./qr-modal";

interface QRButtonProps {
  data: string;
  label?: string;
  className?: string;
  variant?:
    | "default"
    | "outline"
    | "ghost"
    | "secondary"
    | "destructive"
    | "link";
  size?:
    | "default"
    | "xs"
    | "sm"
    | "lg"
    | "icon"
    | "icon-xs"
    | "icon-sm"
    | "icon-lg";
  modalSize?: number;
}

export default function QRButton({
  data,
  label = "QR",
  className = "",
  variant = "ghost",
  size = "sm",
  modalSize = 500,
}: QRButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
        type="button"
      >
        {label}
      </Button>
      <QRModal
        data={data}
        open={open}
        onOpenChange={setOpen}
        modalSize={modalSize}
      />
    </>
  );
}
