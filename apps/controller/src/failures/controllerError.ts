/**
 * A failure the controller raises itself, with a message it wrote: the one kind of failure whose
 * message a failure line carries. Every error class the controller defines extends it, and the
 * controller throws it as it is wherever it fails in words of its own. Its message is fixed text,
 * or names what this release holds, such as one of its migrations; it never quotes another
 * failure's message, a value a request carried, or a value the store returned, but for two: a
 * refusal of the controller's database role names the privileges, and the objects of the database
 * they are held on, that the catalogue reports beyond what the controller needs; and a refusal of a
 * database recording migrations this release does not know names each by its recorded name, only
 * when that is in migration form, which holds nothing but digits, lower-case letters and
 * underscores. A failure it wraps is kept as its `cause`, whose code alone the line carries.
 */
export class ControllerError extends Error {
  override readonly name: string = 'ControllerError';
}
