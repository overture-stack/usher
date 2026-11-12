/**
 * The controller's deadline for a token exchange, in milliseconds: when it must have answered the
 * exchange, measured from the moment the request arrives. Whatever the store or the identity provider
 * does, the controller answers every exchange by then. It is shorter than the bridge's timeout, how
 * long the bridge waits for that answer, by the margin, {@link EXCHANGE_DEADLINE_MARGIN_MILLISECONDS}.
 */
export const CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS = 4000;

/**
 * The margin between the controller's deadline for a token exchange and the bridge's timeout, in
 * milliseconds: the time left after the deadline for the network and for writing the answer, so an
 * answer the controller gives by its deadline still reaches a bridge waiting out its timeout.
 */
export const EXCHANGE_DEADLINE_MARGIN_MILLISECONDS = 1000;

/**
 * The bridge's timeout for a token exchange, in milliseconds: how long a bridge waits for the
 * controller's answer before it gives up. It is the controller's deadline,
 * {@link CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS}, plus the margin,
 * {@link EXCHANGE_DEADLINE_MARGIN_MILLISECONDS}: the least timeout under which a bridge never gives up
 * on an answer the controller gives by its deadline.
 */
export const BRIDGE_EXCHANGE_TIMEOUT_MILLISECONDS: number =
  CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS +
  EXCHANGE_DEADLINE_MARGIN_MILLISECONDS;
