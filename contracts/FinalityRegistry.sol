// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/// @title FinalityRegistry
/// @notice Stores reporter-supplied Portaldot finality snapshots.
///         This contract does not verify BEEFY signatures or GRANDPA justifications.
///         `payloadHash` is the keccak256 of a canonical JSON document kept off chain.
contract FinalityRegistry {
    struct Snapshot {
        uint256 bestBlock;
        uint256 grandpaFinalized;
        uint256 beefyFinalized;
        uint256 beefySetId;
        uint256 beefyAuthorities;
        uint256 skippedSlots;
        bytes32 payloadHash;
        uint256 timestamp;
        address reporter;
    }

    error NotOwner();
    error NotReporter();
    error BadId();

    address public owner;
    mapping(address => bool) public reporters;
    Snapshot[] private _snapshots;

    event ReporterSet(address indexed account, bool allowed);
    event SnapshotPublished(
        uint256 indexed id,
        address indexed reporter,
        bytes32 payloadHash,
        uint256 bestBlock,
        uint256 grandpaFinalized,
        uint256 beefyFinalized
    );

    constructor() {
        owner = msg.sender;
        reporters[msg.sender] = true;
        emit ReporterSet(msg.sender, true);
    }

    function setReporter(address account, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        reporters[account] = allowed;
        emit ReporterSet(account, allowed);
    }

    function publish(
        uint256 bestBlock,
        uint256 grandpaFinalized,
        uint256 beefyFinalized,
        uint256 beefySetId,
        uint256 beefyAuthorities,
        uint256 skippedSlots,
        bytes32 payloadHash
    ) external returns (uint256 id) {
        if (!reporters[msg.sender]) revert NotReporter();
        id = _snapshots.length;
        _snapshots.push(
            Snapshot({
                bestBlock: bestBlock,
                grandpaFinalized: grandpaFinalized,
                beefyFinalized: beefyFinalized,
                beefySetId: beefySetId,
                beefyAuthorities: beefyAuthorities,
                skippedSlots: skippedSlots,
                payloadHash: payloadHash,
                timestamp: block.timestamp,
                reporter: msg.sender
            })
        );
        emit SnapshotPublished(
            id,
            msg.sender,
            payloadHash,
            bestBlock,
            grandpaFinalized,
            beefyFinalized
        );
    }

    function count() external view returns (uint256) {
        return _snapshots.length;
    }

    function get(uint256 id) external view returns (Snapshot memory) {
        if (id >= _snapshots.length) revert BadId();
        return _snapshots[id];
    }

    /// @notice GRANDPA-finalized block minus BEEFY-finalized block.
    ///         Returns 0 when the stored BEEFY number is ahead of GRANDPA.
    function beefyLag(uint256 id) external view returns (uint256) {
        if (id >= _snapshots.length) revert BadId();
        Snapshot memory snap = _snapshots[id];
        if (snap.grandpaFinalized < snap.beefyFinalized) return 0;
        return snap.grandpaFinalized - snap.beefyFinalized;
    }
}
