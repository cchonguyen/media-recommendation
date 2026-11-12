import { describe, expect, it } from "vitest";
import { parseStructuredLine } from "./structured";

describe("parseStructuredLine", () => {
  it("reads the real inbox template lines", () => {
    expect(parseStructuredLine("Severance (TV) | Recommender: Self | Notes: ", 0)).toMatchObject({
      lineIndex: 0, title: "Severance", mediaType: "TV", recommenderName: "Self", trustWeight: 3,
      isAlreadyConsumed: false, personalNotes: "", yearHint: null, myRating: null, consumedYear: null,
    });
    expect(parseStructuredLine("Avengers: Doomsday (Movie) | Recommender: Self | Notes:", 3)).toMatchObject({
      lineIndex: 3, title: "Avengers: Doomsday", mediaType: "Movie",
    });
    expect(
      parseStructuredLine("The Legend of Zelda: Ocarina of Time Remake (Game) | Status: Active | Recommender: Self | Notes: Currently playing", 7),
    ).toMatchObject({ title: "The Legend of Zelda: Ocarina of Time Remake", mediaType: "Game", isAlreadyConsumed: false, personalNotes: "Status: Active | Currently playing" });
    expect(
      parseStructuredLine("Hacks (TV) | Status: Completed | Consumed: 2026 | Recommender: Self | Notes: Just finished", 8),
    ).toMatchObject({ title: "Hacks", mediaType: "TV", isAlreadyConsumed: true, consumedYear: 2026, personalNotes: "Just finished" });
  });

  it("reads recommender trust, year, rating and a Type field", () => {
    expect(parseStructuredLine("Dune (Movie, 2021) | Recommender: justin | Rating: 4.5", 0)).toMatchObject({
      title: "Dune", mediaType: "Movie", yearHint: 2021, recommenderName: "justin", trustWeight: 5, myRating: 4.5, isAlreadyConsumed: true,
    });
    expect(parseStructuredLine("Look Back (2026) | Type: Movie | Recommender: Self", 0)).toMatchObject({
      title: "Look Back", mediaType: "Movie", yearHint: 2026,
    });
  });

  it("leaves anything without the template or a type to the model", () => {
    for (const line of [
      "Dune 2021 from Justin",
      "Dune (2021)",
      "Look Back (2026) | Recommender: Self | Notes: ",
      "watched Severance | loved it",
      "(TV) | Recommender: Self",
      "buy milk",
    ]) {
      expect(parseStructuredLine(line, 0)).toBeNull();
    }
  });

  it("keeps parentheses that are part of the title", () => {
    expect(parseStructuredLine("Birdman (or The Unexpected Virtue) | Type: Movie", 0)).toMatchObject({
      title: "Birdman (or The Unexpected Virtue)", mediaType: "Movie",
    });
  });
});
