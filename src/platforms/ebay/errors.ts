export class EbayError extends Error {
  constructor(
    public status: number,
    message: string,
    public isAuth: boolean,
  ) {
    super(message);
    this.name = 'EbayError';
  }
}
