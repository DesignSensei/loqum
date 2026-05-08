// services/memberService.js

const EmployerMember = require("../models/EmployerMember");
const Branch = require("../models/Branch");
const User = require("../models/User");
const logger = require("../utils/logger");

class MemberService {
  /* ---------- Get All Members for a Business ---------- */
  static async getBusinessMembers({ businessId }) {
    const members = await EmployerMember.find({ business: businessId })
      .populate("user", "firstName lastName email")
      .populate("branch", "name address")
      .sort({ createdAt: -1 });

    return members;
  }

  /* ---------- Get All Members for a Specific Branch ---------- */
  static async getBranchMembers({ branchId, businessId }) {
    // Validate branch belongs to this business
    const branch = await Branch.findOne({ _id: branchId, business: businessId });
    if (!branch) throw new Error("Branch not found");

    const members = await EmployerMember.find({
      business: businessId,
      branch: branchId,
    })
      .populate("user", "firstName lastName email")
      .populate("branch", "name address")
      .sort({ createdAt: -1 });

    return members;
  }

  /* ---------- Reassign Member to a Different Branch ---------- */
  static async reassignMember({ memberId, newBranchId, businessId }) {
    // Validate new branch belongs to this business
    const branch = await Branch.findOne({ _id: newBranchId, business: businessId });
    if (!branch) throw new Error("Branch not found");

    const member = await EmployerMember.findOne({
      _id: memberId,
      business: businessId,
    });

    if (!member) throw new Error("Member not found");

    // Prevent reassigning to the same branch
    if (member.branch.toString() === newBranchId.toString()) {
      throw new Error("Member is already assigned to this branch");
    }

    member.branch = newBranchId;
    await member.save();

    logger.info(`Member ${memberId} reassigned to branch ${newBranchId}`);
    return member;
  }

  /* ---------- Change a Member's Role ---------- */
  static async changeMemberRole({ memberId, newRole, businessId }) {
    const member = await EmployerMember.findOne({
      _id: memberId,
      business: businessId,
    });

    if (!member) throw new Error("Member not found");

    // Prevent updating to the same role
    if (member.role === newRole) {
      throw new Error(`Member is already a ${newRole}`);
    }

    member.role = newRole;
    await member.save();

    logger.info(`Member ${memberId} role changed to ${newRole}`);
    return member;
  }

  /* ---------- Remove a Member ---------- */
  static async removeMember({ memberId, businessId }) {
    const member = await EmployerMember.findOne({
      _id: memberId,
      business: businessId,
    });

    if (!member) throw new Error("Member not found");

    await EmployerMember.findByIdAndDelete(memberId);

    // Reset the user's onboarding state
    await User.findByIdAndUpdate(member.user, {
      isOnboarded: false,
      employerProfile: null,
    });

    logger.info(`Member ${memberId} removed from business ${businessId}`);
    return true;
  }

  /* ---------- Update Member Account Status ---------- */
  static async updateMemberStatus({ memberId, businessId, status }) {
    const member = await EmployerMember.findOne({
      _id: memberId,
      business: businessId,
    });

    if (!member) throw new Error("Member not found");

    if (member.accountStatus === status) {
      throw new Error(`Member is already ${status}`);
    }

    member.accountStatus = status;
    await member.save();

    logger.info(`Member ${memberId} status updated to ${status}`);
    return member;
  }
}

module.exports = MemberService;
