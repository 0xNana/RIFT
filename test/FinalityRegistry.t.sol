// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "forge-std/Test.sol";
import "../contracts/FinalityRegistry.sol";

contract FinalityRegistryTest is Test {
    FinalityRegistry internal registry;
    address internal stranger = address(0x1111);

    function setUp() public {
        registry = new FinalityRegistry();
    }

    function testDeployerCanPublish() public {
        uint256 id = registry.publish(100, 90, 80, 7, 2, 3, keccak256("snapshot"));
        assertEq(id, 0);
        assertEq(registry.count(), 1);
        assertEq(registry.beefyLag(0), 10);

        FinalityRegistry.Snapshot memory snap = registry.get(0);
        assertEq(snap.bestBlock, 100);
        assertEq(snap.grandpaFinalized, 90);
        assertEq(snap.beefyFinalized, 80);
        assertEq(snap.beefySetId, 7);
        assertEq(snap.beefyAuthorities, 2);
        assertEq(snap.skippedSlots, 3);
        assertEq(snap.payloadHash, keccak256("snapshot"));
        assertEq(snap.reporter, address(this));
        assertEq(snap.timestamp, block.timestamp);
    }

    function testStrangerCannotPublish() public {
        vm.prank(stranger);
        vm.expectRevert(FinalityRegistry.NotReporter.selector);
        registry.publish(1, 1, 1, 1, 1, 0, bytes32(uint256(1)));
    }

    function testOwnerCanAllowAReporter() public {
        registry.setReporter(stranger, true);
        vm.prank(stranger);
        uint256 id = registry.publish(10, 9, 9, 1, 2, 0, bytes32(uint256(2)));
        assertEq(id, 0);
        assertEq(registry.beefyLag(0), 0);
    }

    function testStrangerCannotSetReporter() public {
        vm.prank(stranger);
        vm.expectRevert(FinalityRegistry.NotOwner.selector);
        registry.setReporter(stranger, true);
    }

    function testBeefyAheadOfGrandpaReportsZeroLag() public {
        registry.publish(10, 8, 9, 1, 2, 0, bytes32(uint256(3)));
        assertEq(registry.beefyLag(0), 0);
    }

    function testMissingIdReverts() public {
        vm.expectRevert(FinalityRegistry.BadId.selector);
        registry.get(0);
        vm.expectRevert(FinalityRegistry.BadId.selector);
        registry.beefyLag(0);
    }
}
