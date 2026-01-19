import QRImage from "./qr-image";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

interface QRModalProps {
  data: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modalSize?: number;
}

export default function QRModal({
  data,
  open,
  onOpenChange,
  modalSize = 500,
}: QRModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>QR Code</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          <QRImage data={data} size={modalSize} className="mx-auto" />

          <div className="w-full mt-4">
            <div className="text-xs text-muted-foreground mb-1">Data:</div>
            <code className="text-xs break-all block p-2 bg-muted rounded">
              {data}
            </code>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
