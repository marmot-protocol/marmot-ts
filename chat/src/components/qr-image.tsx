interface QRImageProps {
  data: string;
  size?: number;
  className?: string;
}

export default function QRImage({
  data,
  size = 150,
  className = "",
}: QRImageProps) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}`;

  return (
    <img
      src={qrUrl}
      alt="QR Code"
      className={`rounded-lg p-2 bg-white ${className}`}
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}
