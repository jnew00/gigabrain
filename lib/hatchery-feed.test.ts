import { describe, expect, it } from "vitest";
import {
  FEED_PAYLOAD_SHAPES,
  isRequestShapeComplaint,
  shapeOrder,
} from "./hatchery-feed";

describe("candidate payloads", () => {
  it("leads with the tuple shape this API uses everywhere else", () => {
    // gameItemBalanceChanges returns {id, amount}; nothing else in the API
    // returns {itemId, amount}.
    expect(FEED_PAYLOAD_SHAPES[0].build("4442", 578)).toEqual({
      petId: "4442",
      items: [{ id: 578, amount: 1 }],
    });
  });

  it("names `items` in every candidate, since the server already asked for it", () => {
    for (const shape of FEED_PAYLOAD_SHAPES) {
      expect(shape.build("4442", 578)).toHaveProperty("items");
    }
  });

  it("never feeds more than one unit, whatever the shape", () => {
    // The cap on how wrong a wrong guess can go: if an accepted shape means
    // something other than we assumed, it costs one material.
    for (const shape of FEED_PAYLOAD_SHAPES) {
      const body = JSON.stringify(shape.build("4442", 578));
      expect(body).not.toMatch(/"amount":\s*(?!1\b)\d+/);
    }
  });

  it("carries the pet and the item in each candidate", () => {
    for (const shape of FEED_PAYLOAD_SHAPES) {
      const body = JSON.stringify(shape.build("4442", 578));
      expect(body).toContain("4442");
      expect(body).toContain("578");
    }
  });
});

describe("only a complaint about the request climbs the ladder", () => {
  it("recognises the error the server actually returned", () => {
    expect(isRequestShapeComplaint("items are required")).toBe(true);
  });

  it("recognises other validation phrasings", () => {
    expect(isRequestShapeComplaint("petId must be a number")).toBe(true);
    expect(isRequestShapeComplaint("Invalid payload")).toBe(true);
    expect(isRequestShapeComplaint("missing items")).toBe(true);
  });

  it("stops on a refusal about the game, not the request", () => {
    // These are understood requests with real answers. Re-sending them in four
    // spellings would ask the same question four times.
    expect(isRequestShapeComplaint("Not enough Incube")).toBe(false);
    expect(isRequestShapeComplaint("Insufficient items")).toBe(false);
    expect(isRequestShapeComplaint("Egg is already complete")).toBe(false);
    expect(isRequestShapeComplaint("Player has reached max runs")).toBe(false);
  });

  it("treats an absent message as a game refusal, so it does not guess on silence", () => {
    expect(isRequestShapeComplaint(null)).toBe(false);
    expect(isRequestShapeComplaint(undefined)).toBe(false);
    expect(isRequestShapeComplaint("")).toBe(false);
  });
});

describe("try order", () => {
  it("starts from the shape already known to work", () => {
    expect(shapeOrder(2)[0]).toBe(2);
  });

  it("still covers every other shape, so a contract change recovers", () => {
    const order = shapeOrder(2);
    expect(new Set(order).size).toBe(FEED_PAYLOAD_SHAPES.length);
    expect(order).toHaveLength(FEED_PAYLOAD_SHAPES.length);
  });

  it("is the plain order when nothing has been learned", () => {
    expect(shapeOrder(0)).toEqual(FEED_PAYLOAD_SHAPES.map((_, i) => i));
  });
});
