import { MlsMessage, MlsPrivateMessage, wireformats } from "ts-mls";

export type PrivateMessage = MlsPrivateMessage;

/** Check if a MLSMessage is a private message */
export function isPrivateMessage(
  message: MlsMessage,
): message is PrivateMessage {
  return message.wireformat === wireformats.mls_private_message;
}
