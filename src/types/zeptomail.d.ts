/** Ambient typings — zeptomail package.json exports do not resolve types under moduleResolution=bundler. */
declare module "zeptomail" {
  export class SendMailClient {
    constructor(opts: { url: string; token: string });
    sendMail(payload: unknown): Promise<unknown>;
  }
}
