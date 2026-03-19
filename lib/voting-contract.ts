// Abstract Portal Voting Contract — mainnet
// Source: https://build.abs.xyz/docs/abstract-portal/abstract-app-voting

export const ABSTRACT_VOTING_ADDRESS = "0x3b50de27506f0a8c1f4122a1e6f470009a76ce2a" as const;

export const GIGAVERSE_APP_ID = BigInt(39);

export const ABSTRACT_VOTING_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "appId", type: "uint256" }],
    name: "voteForApp",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "currentEpoch",
    outputs: [{ internalType: "uint256", name: "epoch", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "user", type: "address" },
      { internalType: "uint256", name: "epoch", type: "uint256" },
    ],
    name: "getUserVotes",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "user", type: "address" }],
    name: "userVotesRemaining",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "voteCost",
    outputs: [{ internalType: "uint96", name: "", type: "uint96" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
